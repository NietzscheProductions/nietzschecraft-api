import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGINS = "*";

// Blocks your hotbar actually supports (1-8). Keep this in
// sync with the client's block set.
const VALID_BLOCK_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, X-Player-Id",
        "Content-Type": "application/json"
    };
}

function json(data, status = 200) {
    return new Response(
        JSON.stringify(data),
        {
            status,
            headers: corsHeaders()
        }
    );
}

// Basic shared-secret check for write endpoints. This is not
// strong auth (the key lives in client-side JS, so anyone who
// opens dev tools can read it) — it just filters out casual
// scripts/bots hitting the API without ever loading the game.
function isAuthorized(request, env) {

    if (!env.API_KEY) {
        // No key configured — fail open would defeat the point,
        // fail closed so misconfiguration is loud, not silent.
        return false;
    }

    const provided = request.headers.get("X-Api-Key");

    return provided === env.API_KEY;
}

// Cheap IP-based flood protection on top of the key check.
// Uses the Workers Rate Limiting binding (GA) — no external
// service, config lives in wrangler.toml.
async function checkGlobalLimit(request, env) {

    if (!env.GLOBAL_LIMITER) {
        return true;
    }

    const ip =
        request.headers.get("CF-Connecting-IP") || "unknown";

    const { success } =
        await env.GLOBAL_LIMITER.limit({ key: ip });

    return success;
}

// ============================================================
// PLAYER SESSION DURABLE OBJECT
// ============================================================
//
// One instance per player id (from the X-Player-Id header).
// The static API key proves the request came from your game
// client; this object adds a second, independent layer on top
// of that: it won't let a single player id spam writes, and it
// rejects block edits or position updates that are physically
// implausible given where that player was last seen — the kind
// of thing a script bypassing your client's own limits would do.
//
// Rate counters live in memory (cheap, no D1 round trip per
// check) and reset if the object cold-starts; last known
// position is kept in durable storage so it survives that.

const BLOCK_WRITE_LIMIT = 20;        // block edits
const BLOCK_WRITE_WINDOW_MS = 10000; // per 10 seconds

const PLAYER_WRITE_LIMIT = 10;        // position updates
const PLAYER_WRITE_WINDOW_MS = 10000; // per 10 seconds

const MAX_REACH_BLOCKS = 8;      // block edit vs last known position
const MAX_TELEPORT_BLOCKS = 60;  // implausible single-step jump

export class PlayerSession extends DurableObject {

    constructor(ctx, env) {

        super(ctx, env);

        this.ctx = ctx;
        this.env = env;

        this.blockWriteTimes = [];
        this.playerWriteTimes = [];
        this.lastPosition = null;

        this.ctx.blockConcurrencyWhile(async () => {

            this.lastPosition =
                (await this.ctx.storage.get(
                    "lastPosition"
                )) || null;

        });

    }

    withinRate(timesArray, limit, windowMs) {

        const now = Date.now();

        const recent =
            timesArray.filter(
                t => now - t < windowMs
            );

        recent.push(now);

        return {
            allowed: recent.length <= limit,
            updated: recent
        };

    }

    async fetch(request) {

        const url = new URL(request.url);

        try {

            if (url.pathname === "/write-block") {

                return await this.handleWriteBlock(request);

            }

            if (url.pathname === "/write-player") {

                return await this.handleWritePlayer(request);

            }

            return json({ error: "Not found" }, 404);

        } catch (error) {

            return json({
                error: "Session error: " + error.message
            }, 500);

        }

    }

    async handleWriteBlock(request) {

        const body = await request.json();

        const { allowed, updated } =
            this.withinRate(
                this.blockWriteTimes,
                BLOCK_WRITE_LIMIT,
                BLOCK_WRITE_WINDOW_MS
            );

        this.blockWriteTimes = updated;

        if (!allowed) {

            return json({
                error: "Placing/breaking blocks too fast"
            }, 429);

        }

        const worldId = String(body.world_id || "");
        const x = Number(body.x);
        const y = Number(body.y);
        const z = Number(body.z);

        let blockId = null;

        if (body.block_id !== null && body.block_id !== undefined) {
            blockId = Number(body.block_id);
        }

        if (
            !worldId ||
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            !Number.isInteger(z)
        ) {

            return json({ error: "Invalid block coordinates" }, 400);

        }

        if (blockId !== null && !VALID_BLOCK_IDS.has(blockId)) {

            return json({ error: "Invalid block ID" }, 400);

        }

        if (this.lastPosition) {

            const dx = x - this.lastPosition.x;
            const dy = y - this.lastPosition.y;
            const dz = z - this.lastPosition.z;

            const distance =
                Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (distance > MAX_REACH_BLOCKS) {

                return json({
                    error: "Block is out of reach"
                }, 400);

            }

        }

        if (blockId === null) {

            await this.env.DB
                .prepare(`
                    DELETE FROM world_changes
                    WHERE world_id = ? AND x = ? AND y = ? AND z = ?
                `)
                .bind(worldId, x, y, z)
                .run();

        } else {

            await this.env.DB
                .prepare(`
                    INSERT INTO world_changes (world_id, x, y, z, block_id)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(world_id, x, y, z)
                    DO UPDATE SET block_id = excluded.block_id
                `)
                .bind(worldId, x, y, z, blockId)
                .run();

        }

        return json({ success: true });

    }

    async handleWritePlayer(request) {

        const body = await request.json();

        const { allowed, updated } =
            this.withinRate(
                this.playerWriteTimes,
                PLAYER_WRITE_LIMIT,
                PLAYER_WRITE_WINDOW_MS
            );

        this.playerWriteTimes = updated;

        if (!allowed) {

            return json({
                error: "Saving position too often"
            }, 429);

        }

        const id = String(body.id || "");
        const worldId = String(body.world_id || "");
        const x = Number(body.x);
        const y = Number(body.y);
        const z = Number(body.z);
        const yaw = Number(body.yaw || 0);
        const pitch = Number(body.pitch || 0);

        if (
            !id || !worldId ||
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(z) ||
            !Number.isFinite(yaw) ||
            !Number.isFinite(pitch)
        ) {

            return json({ error: "Invalid player data" }, 400);

        }

        if (this.lastPosition) {

            const dx = x - this.lastPosition.x;
            const dy = y - this.lastPosition.y;
            const dz = z - this.lastPosition.z;

            const distance =
                Math.sqrt(dx * dx + dy * dy + dz * dz);

            // Generous — this only catches obvious teleport
            // hacks, not normal sprinting/falling.
            if (distance > MAX_TELEPORT_BLOCKS) {

                return json({
                    error: "Implausible movement rejected"
                }, 400);

            }

        }

        this.lastPosition = { x, y, z };

        await this.ctx.storage.put(
            "lastPosition",
            this.lastPosition
        );

        await this.env.DB
            .prepare(`
                INSERT INTO players (id, world_id, x, y, z, yaw, pitch)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    world_id = excluded.world_id,
                    x = excluded.x,
                    y = excluded.y,
                    z = excluded.z,
                    yaw = excluded.yaw,
                    pitch = excluded.pitch,
                    updated_at = CURRENT_TIMESTAMP
            `)
            .bind(id, worldId, x, y, z, yaw, pitch)
            .run();

        return json({ success: true });

    }

}


export default {

    async fetch(request, env) {

        // ----------------------------------------------------
        // CORS
        // ----------------------------------------------------

        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: corsHeaders()
            });
        }


        const url =
            new URL(request.url);

        const path =
            url.pathname;


        // ----------------------------------------------------
        // HEALTH CHECK
        // ----------------------------------------------------

        if (
            path === "/" &&
            request.method === "GET"
        ) {

            return json({
                ok: true,
                service: "NietzscheCraft API",
                version: "0.7"
            });

        }


        // ----------------------------------------------------
        // CREATE WORLD
        // ----------------------------------------------------

        if (
            path === "/world" &&
            request.method === "POST"
        ) {

            if (!isAuthorized(request, env)) {

                return json({
                    error: "Unauthorized"
                }, 401);

            }

            if (!(await checkGlobalLimit(request, env))) {

                return json({
                    error: "Too many requests"
                }, 429);

            }


            let body;

            try {

                body =
                    await request.json();

            } catch {

                return json({
                    error: "Invalid JSON"
                }, 400);

            }


            const worldId =
                String(
                    body.id ||
                    crypto.randomUUID()
                );

            const name =
                String(
                    body.name ||
                    "NietzscheCraft World"
                );

            const seed =
                Number(
                    body.seed ??
                    Math.floor(
                        Math.random() *
                        2147483647
                    )
                );


            if (
                !Number.isFinite(seed)
            ) {

                return json({
                    error: "Invalid seed"
                }, 400);

            }


            try {

                await env.DB
                    .prepare(`
                        INSERT INTO worlds
                        (
                            id,
                            name,
                            seed
                        )
                        VALUES (?, ?, ?)
                    `)
                    .bind(
                        worldId,
                        name,
                        seed
                    )
                    .run();

            } catch (error) {

                const message =
                    String(
                        error && error.message || ""
                    );


                if (
                    message.includes("UNIQUE") ||
                    message.includes("PRIMARY KEY")
                ) {

                    return json({
                        error: "World already exists"
                    }, 409);

                }


                return json({
                    error: "Could not create world"
                }, 500);

            }


            return json({
                success: true,
                id: worldId,
                name,
                seed
            }, 201);

        }


        // ----------------------------------------------------
        // GET WORLD
        // ----------------------------------------------------

        if (
            path.startsWith("/world/") &&
            request.method === "GET"
        ) {

            const worldId =
                decodeURIComponent(
                    path.substring(
                        "/world/".length
                    )
                );


            const world =
                await env.DB
                    .prepare(`
                        SELECT
                            id,
                            name,
                            seed,
                            created_at
                        FROM worlds
                        WHERE id = ?
                    `)
                    .bind(worldId)
                    .first();


            if (!world) {

                return json({
                    error: "World not found"
                }, 404);

            }


            return json({
                world
            });

        }


        // ----------------------------------------------------
        // LOAD WORLD CHANGES (optionally region-scoped)
        // ----------------------------------------------------
        //
        // Pass minX/maxX/minZ/maxZ (block coordinates) to only
        // fetch changes inside that box. Omit all four to get
        // the old "everything" behavior (kept for compatibility,
        // but not recommended once a world has a lot of history).

        if (
            path === "/changes" &&
            request.method === "GET"
        ) {

            const worldId =
                url.searchParams.get(
                    "world"
                );


            if (!worldId) {

                return json({
                    error: "Missing world parameter"
                }, 400);

            }


            const rawBounds = [
                "minX",
                "maxX",
                "minZ",
                "maxZ"
            ].map(
                key => url.searchParams.get(key)
            );

            const boundsProvided =
                rawBounds.some(v => v !== null);


            let results;

            if (boundsProvided) {

                if (rawBounds.some(v => v === null)) {

                    return json({
                        error:
                            "minX, maxX, minZ, and maxZ must all be provided together"
                    }, 400);

                }


                const [minX, maxX, minZ, maxZ] =
                    rawBounds.map(Number);


                if (
                    ![minX, maxX, minZ, maxZ].every(
                        Number.isFinite
                    )
                ) {

                    return json({
                        error: "Bounds must be numbers"
                    }, 400);

                }


                results =
                    await env.DB
                        .prepare(`
                            SELECT
                                x,
                                y,
                                z,
                                block_id
                            FROM world_changes
                            WHERE world_id = ?
                              AND x BETWEEN ? AND ?
                              AND z BETWEEN ? AND ?
                        `)
                        .bind(
                            worldId,
                            minX,
                            maxX,
                            minZ,
                            maxZ
                        )
                        .all();

            } else {

                results =
                    await env.DB
                        .prepare(`
                            SELECT
                                x,
                                y,
                                z,
                                block_id
                            FROM world_changes
                            WHERE world_id = ?
                        `)
                        .bind(worldId)
                        .all();

            }


            return json({
                changes:
                    results.results || []
            });

        }


        // ----------------------------------------------------
        // SAVE BLOCK CHANGE
        // ----------------------------------------------------

        if (
            path === "/changes" &&
            request.method === "POST"
        ) {

            if (!isAuthorized(request, env)) {

                return json({
                    error: "Unauthorized"
                }, 401);

            }

            if (!(await checkGlobalLimit(request, env))) {

                return json({
                    error: "Too many requests"
                }, 429);

            }


            const playerId =
                request.headers.get("X-Player-Id");

            if (!playerId) {

                return json({
                    error: "Missing X-Player-Id header"
                }, 400);

            }


            let body;

            try {

                body =
                    await request.json();

            } catch {

                return json({
                    error: "Invalid JSON"
                }, 400);

            }


            const id =
                env.PLAYER_SESSION.idFromName(playerId);

            const stub =
                env.PLAYER_SESSION.get(id);

            const doResponse =
                await stub.fetch(
                    "https://player-session/write-block",
                    {
                        method: "POST",
                        body: JSON.stringify(body)
                    }
                );

            const data =
                await doResponse.json();

            return json(data, doResponse.status);

        }


        // ----------------------------------------------------
        // SAVE PLAYER
        // ----------------------------------------------------

        if (
            path === "/player" &&
            request.method === "POST"
        ) {

            if (!isAuthorized(request, env)) {

                return json({
                    error: "Unauthorized"
                }, 401);

            }

            if (!(await checkGlobalLimit(request, env))) {

                return json({
                    error: "Too many requests"
                }, 429);

            }


            const playerId =
                request.headers.get("X-Player-Id");

            if (!playerId) {

                return json({
                    error: "Missing X-Player-Id header"
                }, 400);

            }


            let body;

            try {

                body =
                    await request.json();

            } catch {

                return json({
                    error: "Invalid JSON"
                }, 400);

            }


            // The header owns which DO we talk to — never trust
            // a client-supplied id that doesn't match it.
            body.id = playerId;


            const id =
                env.PLAYER_SESSION.idFromName(playerId);

            const stub =
                env.PLAYER_SESSION.get(id);

            const doResponse =
                await stub.fetch(
                    "https://player-session/write-player",
                    {
                        method: "POST",
                        body: JSON.stringify(body)
                    }
                );

            const data =
                await doResponse.json();

            return json(data, doResponse.status);

        }


        // ----------------------------------------------------
        // LOAD PLAYER
        // ----------------------------------------------------

        if (
            path === "/player" &&
            request.method === "GET"
        ) {

            const id =
                url.searchParams.get(
                    "id"
                );


            if (!id) {

                return json({
                    error: "Missing player id"
                }, 400);

            }


            const player =
                await env.DB
                    .prepare(`
                        SELECT
                            id,
                            world_id,
                            x,
                            y,
                            z,
                            yaw,
                            pitch,
                            updated_at
                        FROM players
                        WHERE id = ?
                    `)
                    .bind(id)
                    .first();


            return json({
                player:
                    player || null
            });

        }


        // ----------------------------------------------------
        // NOT FOUND
        // ----------------------------------------------------

        return json({
            error: "Route not found"
        }, 404);

    }

};

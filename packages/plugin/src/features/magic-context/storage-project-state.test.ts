import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    bumpProjectMemoryEpoch,
    bumpProjectUserProfileVersion,
    deleteProjectState,
    ensureProjectState,
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getProjectState,
    setProjectState,
} from "./storage-project-state";
import { createDirectTestDatabase } from "./test-database";

let db: Database | null = null;

function makeDb(): Database {
    db = createDirectTestDatabase().db;
    return db;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
});

describe("storage-project-state", () => {
    test("lazily creates and bumps project-scoped epochs", () => {
        const database = makeDb();

        expect(getProjectState(database, "git:abc")).toBeNull();
        expect(ensureProjectState(database, "git:abc", 10)).toEqual({
            projectPath: "git:abc",
            projectMemoryEpoch: 0,
            projectUserProfileVersion: 0,
            updatedAt: 10,
        });
        expect(bumpProjectMemoryEpoch(database, "git:abc", 20)).toEqual({
            projectPath: "git:abc",
            projectMemoryEpoch: 1,
            projectUserProfileVersion: 0,
            updatedAt: 20,
        });
        expect(bumpProjectMemoryEpoch(database, "git:abc", 30).projectMemoryEpoch).toBe(2);
    });

    test("reuses the prepared read statement without changing returned state", () => {
        const database = makeDb();
        setProjectState(database, "git:cached", {
            projectMemoryEpoch: 7,
            projectUserProfileVersion: 3,
            updatedAt: 99,
        });
        let selectPrepares = 0;
        const observedDb = new Proxy(database, {
            get(target, property, receiver) {
                if (property === "prepare") {
                    return (sql: string) => {
                        if (
                            sql.includes("FROM project_state") &&
                            sql.includes("WHERE project_path")
                        ) {
                            selectPrepares += 1;
                        }
                        return target.prepare(sql);
                    };
                }
                return Reflect.get(target, property, receiver);
            },
        }) as Database;
        const expected = {
            projectPath: "git:cached",
            projectMemoryEpoch: 7,
            projectUserProfileVersion: 3,
            updatedAt: 99,
        };

        expect(getProjectState(observedDb, "git:cached")).toEqual(expected);
        expect(getProjectState(observedDb, "git:cached")).toEqual(expected);
        expect(selectPrepares).toBe(1);
    });

    test("updates user profile sentinel rows and supports set/delete CRUD", () => {
        const database = makeDb();

        expect(bumpProjectUserProfileVersion(database, undefined, 40)).toEqual({
            projectPath: GLOBAL_USER_PROFILE_PROJECT_PATH,
            projectMemoryEpoch: 0,
            projectUserProfileVersion: 1,
            updatedAt: 40,
        });
        expect(
            setProjectState(database, "git:def", {
                projectMemoryEpoch: 4,
                projectUserProfileVersion: 5,
                updatedAt: 60,
            }),
        ).toEqual({
            projectPath: "git:def",
            projectMemoryEpoch: 4,
            projectUserProfileVersion: 5,
            updatedAt: 60,
        });
        expect(deleteProjectState(database, "git:def")).toBe(true);
        expect(getProjectState(database, "git:def")).toBeNull();
    });
});

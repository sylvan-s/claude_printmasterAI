/**
 * Neo4j driver for the ACKG — same AuraDB instance the Python ingestion
 * toolkit (repo-root knowledge_graph/) populates. Reads the identical
 * NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / NEO4J_DATABASE variable names as
 * that toolkit's .env.example, so one shared .env serves both.
 */
import neo4j, { type Driver } from "neo4j-driver";
import dotenv from "dotenv";

dotenv.config();

let driver: Driver | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy knowledge_graph/.env.example (repo root) to .env, fill in ` +
      `the real AuraDB values, and ensure they're loaded (dotenv picks up a root .env ` +
      `automatically). The ACKG query tool is unavailable until this is set.`
    );
  }
  return value;
}

/** Lazily created, reused across calls — never construct a driver per query. */
export function getDriver(): Driver {
  if (!driver) {
    const uri = requireEnv("NEO4J_URI");
    const user = requireEnv("NEO4J_USER");
    const password = requireEnv("NEO4J_PASSWORD");
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driver;
}

export function getDatabase(): string {
  return requireEnv("NEO4J_DATABASE");
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

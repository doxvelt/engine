import { DomainValidationError } from "../core/ports.ts";

/** Installation-local application data, never simulation truth or portable content. */
export type SimulationCollectionItem = {
  simulationId: string;
  scenarioName: string | null;
  createdAt: string;
  openedAt: string | null;
  branchId: string;
};
export type RecordSimulationOpened = {
  ownerScope: string;
  simulationId: string;
  branchId: string;
  operationId: string;
  expectedVersion: string | null;
};
export type NavigationState = { version: string | null };
export type NavigationReceipt = { version: string; openedAt: string };
export interface SimulationCollectionRepository {
  listSimulations(ownerScope: string): SimulationCollectionItem[];
  getNavigationVersion(ownerScope: string): string | null;
  recordSimulationOpened(input: RecordSimulationOpened): NavigationReceipt;
}

/** New navigation tokens have a bounded format; existing saved identities do not. */
export function navigationToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\s/\\\x00-\x1f\x7f]/u.test(value) || value === "." || value === "..")
    throw new DomainValidationError("Invalid navigation token.");
}

/** Match the API's non-empty string validation without changing saved identities. */
export function savedIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value)
    throw new DomainValidationError("Saved identity must be a non-empty string.");
}

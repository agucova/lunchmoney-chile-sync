// Typed failure taxonomy. Every adapter/sink failure is classified into one of these;
// the classification drives failover policy (see docs/phase0-findings.md and PLAN).

/** Base class: all domain errors carry a machine-readable code. */
export abstract class SyncError extends Error {
  abstract readonly code:
    | "schema_drift"
    | "auth_error"
    | "two_factor_timeout"
    | "source_unavailable"
    | "sink_error"
    | "invariant_violation";
}

/**
 * A source payload failed validation. Fail closed: the whole batch is discarded, never
 * partially ingested. `rawPayloadPath` points at the persisted payload for diagnosis.
 */
export class SchemaDriftError extends SyncError {
  override readonly code = "schema_drift";
  constructor(
    message: string,
    readonly rawPayloadPath?: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Bad credentials. Halts every source sharing the credential set (bank lockout risk). */
export class AuthError extends SyncError {
  override readonly code = "auth_error";
}

/**
 * A second factor is required and could not be satisfied headlessly: either the bank asked
 * for an in-app approval that never arrived, or the source demands an MFA challenge we cannot
 * answer (e.g. an untrusted device). Ends the connection's run; the fix is human-actionable
 * (approve the login, or re-establish device trust).
 */
export class TwoFactorTimeoutError extends SyncError {
  override readonly code = "two_factor_timeout";
}

/** Transient: site down, timeout, network. Retry with backoff, then next source. */
export class SourceUnavailableError extends SyncError {
  override readonly code = "source_unavailable";
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Lunch Money API failure that isn't a validation bug on our side. */
export class SinkError extends SyncError {
  override readonly code = "sink_error";
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

/** A design-by-contract violation: a bug in our code, never expected input. */
export class InvariantViolation extends SyncError {
  override readonly code = "invariant_violation";
}

/** Assert an invariant; throwing InvariantViolation marks it as our bug, not bad data. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

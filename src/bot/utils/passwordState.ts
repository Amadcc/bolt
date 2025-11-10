export interface PasswordSessionState {
  passwordExpiresAt?: number;
}

/**
 * Check whether the temporary password is still valid.
 * Clears the timestamp when expired to avoid stale state.
 */
export function hasActivePassword(state: PasswordSessionState): boolean {
  if (!state.passwordExpiresAt) {
    return false;
  }

  if (Date.now() >= state.passwordExpiresAt) {
    state.passwordExpiresAt = undefined;
    return false;
  }

  return true;
}

/**
 * Clear password timestamp after use.
 */
export function clearPasswordState(state: PasswordSessionState): void {
  state.passwordExpiresAt = undefined;
}

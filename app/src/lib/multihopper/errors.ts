/** A routing failure raised in the browser before or while a bundle is signed and broadcast. */
export class RoutingBundleError extends Error {
  constructor(readonly code: string, message: string, readonly signature: string | null = null) {
    super(message);
    this.name = "RoutingBundleError";
  }
}

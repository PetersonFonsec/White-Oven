export interface PushCall {
  session: number;
  signal: AbortSignal;
}
export interface PushApi {
  /** The signed-in identity now; any sign-in or sign-out changes it. */
  session(): number;
  status(call: PushCall): Promise<unknown>;
  register(
    token: string,
    installationId: string,
    call: PushCall,
  ): Promise<unknown>;
  /** Ends this session's subscription and any older one of this installation. */
  unregister(installationId: string, call: PushCall): Promise<unknown>;
}

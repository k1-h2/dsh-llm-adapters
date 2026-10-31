/**
 * The local Trae desktop client's sign-in state.
 *
 * Trae's check-in route insists on the device id its own client registered, so
 * the website login cannot use it. When the client is installed and already
 * signed in, the plugin can reuse that state instead:
 *
 *  - the `Cloud-IDE-JWT` stored under `iCubeAuthInfo://icube.cloudide`;
 *  - the 16-digit device id encoded in the `iCubeAuthInfo://icube-dc:<id>` key;
 *  - `telemetry.machineId`, the value the client sends as `x-machine-id`.
 *
 * The stored value uses the client's own AES-CBC envelope: six magic bytes, a
 * 32-byte key material, then the ciphertext. The AES key and IV are derived
 * from that key material with SHA-512 and a fixed salt, and the plaintext is a
 * SHA-512 digest followed by the JSON document. Nothing here writes to the
 * client, and the token is never returned by the settings API.
 *
 * @module dsh-llm-adapters/trae-client
 */
import type { TraeRegion } from './brand.ts';
import type { ClientLoginStatus } from './types.ts';
/** What the provider stores after importing a client login. */
export interface TraeClientLoginState {
    region: TraeRegion;
    token: string;
    deviceId: string;
    machineId: string;
    userId?: string;
    name?: string;
    expiresAt?: number;
}
/** The settings-facing half (no token) plus the internal state when usable. */
export interface TraeClientDetection {
    status: ClientLoginStatus;
    state?: TraeClientLoginState;
}
export interface TraeClientReadOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
}
/**
 * The client's data directory, most specific first.
 *
 * `DSH_TRAE_CLIENT_DIR` is a portable/test override; the region-specific
 * variables let one machine keep separate CN and international installs.
 */
export declare function traeClientDataDirs(region: TraeRegion, options?: TraeClientReadOptions): string[];
/** Parse one `storage.json` document; exported for tests and diagnostics. */
export declare function parseTraeClientStorage(region: TraeRegion, storage: Record<string, unknown>): TraeClientDetection;
/** Read the currently selected region's client state from this machine. */
export declare function readTraeClientLogin(region: TraeRegion, options?: TraeClientReadOptions): TraeClientDetection;

/**
 * `eas.json` through the official resolver (`@expo/eas-json`, the one EAS CLI uses), so `extends`
 * and per-platform settings mean here exactly what they mean to `eas build` and `eas submit`.
 * ADR 0028: a store's build profile must build that store and only that kind of build; a
 * submission needs only what the chosen platforms need.
 */
import { createRequire } from "node:module";
import { RELEASE_PROFILES, type ReleaseKind } from "../src/config/release.ts";

type EasJsonModule = typeof import("@expo/eas-json");
type EasPlatform = import("@expo/eas-json").Platform;
const { EasJsonAccessor, EasJsonUtils } = createRequire(import.meta.url)(
  "@expo/eas-json",
) as EasJsonModule;

export const PLATFORM_CHOICES = {
  android: ["android"],
  ios: ["ios"],
  all: ["android", "ios"],
} as const;
export type PlatformChoice = keyof typeof PLATFORM_CHOICES;
type Platform = (typeof PLATFORM_CHOICES)[PlatformChoice][number];

export function parsePlatformChoice(value: string): PlatformChoice | null {
  return Object.hasOwn(PLATFORM_CHOICES, value)
    ? (value as PlatformChoice)
    : null;
}

/** The resolver's message on one line, without terminal colors. */
const reason = (error: unknown) =>
  error instanceof Error
    ? error.message
        .replace(new RegExp(String.raw`\u001b\[[0-9;]*m`, "g"), "")
        .replace(/\s*\n[-\s]*/g, "; ")
    : "unreadable";

/** The base profiles a profile extends, nearest first; null on a cycle or a missing parent. */
function extendsChain(
  profiles: Record<string, { extends?: unknown }>,
  name: string,
): string[] | null {
  const chain: string[] = [];
  for (let parent = profiles[name]?.extends; parent !== undefined;) {
    if (
      typeof parent !== "string" ||
      chain.includes(parent) ||
      !profiles[parent]
    )
      return null;
    chain.push(parent);
    parent = profiles[parent]!.extends;
  }
  return chain;
}

export interface BuildProfileCheck {
  profile: string;
  /** The EAS environment whose variables the build receives. */
  environment: string;
  problems: string[];
}

/**
 * The store's profile for this kind, resolved per platform: it must build `slug` (and no other
 * store), carry the kind's `WHITEOVEN_RELEASE`, inherit the kind's base profile and keep its
 * distribution and EAS environment.
 */
export async function checkBuildProfile(
  projectDir: string,
  slug: string,
  kind: ReleaseKind,
  platforms: readonly Platform[],
  profile: string,
): Promise<BuildProfileCheck> {
  const expected = RELEASE_PROFILES[kind];
  const result: BuildProfileCheck = {
    profile,
    environment: expected.environment,
    problems: [],
  };
  const accessor = EasJsonAccessor.fromProjectPath(projectDir);
  let raw: { build?: Record<string, { extends?: unknown }> };
  try {
    raw = await accessor.readRawJsonAsync();
  } catch (error) {
    result.problems.push(`eas.json (${reason(error)})`);
    return result;
  }
  const chain = extendsChain(raw.build ?? {}, profile);
  if (!raw.build?.[profile]) {
    result.problems.push(`eas.json build profile ${profile} (missing)`);
    return result;
  }
  if (!chain?.includes(expected.base))
    result.problems.push(
      `eas.json build profile ${profile} (must extend ${expected.base})`,
    );
  for (const platform of platforms) {
    const where = `eas.json build profile ${profile} (${platform})`;
    let resolved;
    try {
      resolved = await EasJsonUtils.getBuildProfileAsync(
        accessor,
        platform as unknown as EasPlatform,
        profile,
      );
    } catch (error) {
      result.problems.push(`${where}: ${reason(error)}`);
      continue;
    }
    const env = resolved.env ?? {};
    if (env["WHITEOVEN_TENANT"] !== slug)
      result.problems.push(
        `${where}: WHITEOVEN_TENANT must be ${slug}${env["WHITEOVEN_TENANT"] ? `, not ${env["WHITEOVEN_TENANT"]}` : ""}`,
      );
    if (env["WHITEOVEN_RELEASE"] !== kind)
      result.problems.push(`${where}: WHITEOVEN_RELEASE must be ${kind}`);
    if (resolved.distribution !== expected.distribution)
      result.problems.push(
        `${where}: distribution must be ${expected.distribution}`,
      );
    if ((resolved.environment ?? expected.environment) !== expected.environment)
      result.problems.push(
        `${where}: environment must be ${expected.environment}`,
      );
    if (resolved.environment) result.environment = resolved.environment;
  }
  return result;
}

export interface SubmitProfileCheck {
  /** The submit profile `eas build --auto-submit-with-profile` gets. */
  profile: string;
  problems: string[];
}

/**
 * The submit profile for this store: `{slug}` when `eas.json` has one (it adds the App Store
 * Connect app id), otherwise `production`. Each chosen platform needs only its own settings:
 * Android goes to a non-production track as a draft; iOS needs `ascAppId`. Credentials never
 * come from files in the repository; they live on EAS.
 */
export async function checkSubmitProfile(
  projectDir: string,
  slug: string,
  kind: ReleaseKind,
  platforms: readonly Platform[],
): Promise<SubmitProfileCheck> {
  const accessor = EasJsonAccessor.fromProjectPath(projectDir);
  const problems: string[] = [];
  if (kind !== "store")
    return {
      profile: "",
      problems: ["submit (only a store build goes to the stores)"],
    };
  let names: string[];
  try {
    names = await EasJsonUtils.getSubmitProfileNamesAsync(accessor);
  } catch (error) {
    return { profile: "", problems: [`eas.json (${reason(error)})`] };
  }
  const profile = names.includes(slug) ? slug : "production";
  if (!names.includes(profile))
    return {
      profile,
      problems: [`eas.json submit profile ${profile} (missing)`],
    };
  for (const platform of platforms) {
    const where = `eas.json submit profile ${profile} (${platform})`;
    let resolved: Record<string, unknown>;
    try {
      resolved = (await EasJsonUtils.getSubmitProfileAsync(
        accessor,
        platform as unknown as EasPlatform,
        profile,
      )) as unknown as Record<string, unknown>;
    } catch (error) {
      problems.push(`${where}: ${reason(error)}`);
      continue;
    }
    if (platform === "android") {
      if (resolved["track"] === "production" || !resolved["track"])
        problems.push(
          `${where}: track must be a testing track, not production`,
        );
      if (resolved["releaseStatus"] !== "draft")
        problems.push(`${where}: releaseStatus must be draft`);
      if (resolved["serviceAccountKeyPath"])
        problems.push(`${where}: the service account key lives on EAS`);
    } else {
      if (
        typeof resolved["ascAppId"] !== "string" ||
        !/^\d+$/.test(resolved["ascAppId"])
      )
        problems.push(
          `${where}: ascAppId missing; add the submit profile "${slug}" extending production with ios.ascAppId`,
        );
      if (resolved["ascApiKeyPath"])
        problems.push(`${where}: the App Store Connect key lives on EAS`);
    }
  }
  return { profile, problems };
}

/** What `spawnSync` reports about the `eas env:exec` run; its output is never read. */
export interface EasRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/**
 * Turns the `eas env:exec` run of `api-url-check.ts` into the pre-flight's own message: null when
 * the address passed (exit 0), a fixed message for exit 3 (the check refused the address), and a
 * fixed message for anything else, including a CLI that did not start or died by a signal. The
 * CLI's stdout and stderr are discarded, so no token, URL or other output can reach the log.
 */
export function easApiUrlProblem(
  run: EasRunResult,
  environment: string,
): string | null {
  if (!run.error && run.signal === null && run.status === 0) return null;
  if (!run.error && run.signal === null && run.status === 3)
    return `WHITEOVEN_API_URL is missing or invalid in the EAS "${environment}" environment (set an HTTPS address, plain text or sensitive)`;
  if (!run.error && run.signal === null && run.status === 4)
    return `The API of the EAS "${environment}" environment has no approved privacy policy and terms of use for this store (publish them, ADR 0030)`;
  return `Could not validate the EAS "${environment}" environment (check EXPO_TOKEN, access to the store's EAS project and the environment name)`;
}

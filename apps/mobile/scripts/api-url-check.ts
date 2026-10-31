/**
 * Runs inside `eas env:exec <environment>` (ADR 0028): checks the `WHITEOVEN_API_URL` the EAS
 * environment would hand the build, with the same rule as the worker. Prints only which rule
 * failed, never the value. Exit 3 means the address is missing or invalid. Under `release-check
 * --eas` this output is discarded with the rest of the EAS CLI's; only the exit status counts.
 */
import { apiUrlReleaseProblems } from "../src/config/release.ts";

const problems = apiUrlReleaseProblems(process.env.WHITEOVEN_API_URL);
for (const problem of problems) console.error(`- ${problem}`);
process.exit(problems.length ? 3 : 0);

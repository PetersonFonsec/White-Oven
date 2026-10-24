// Container probe: exits 0 only when GET /health answers 200 within the timeout.
import { get } from "node:http";
const port = process.env.API_PORT || "3000";
const request = get(
  { host: "127.0.0.1", port, path: "/health", timeout: 3000 },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on("timeout", () => request.destroy());
request.on("error", () => process.exit(1));

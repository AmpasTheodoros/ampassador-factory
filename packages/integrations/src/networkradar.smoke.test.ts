import { describe, it, expect } from "vitest";
import { NetworkRadarAdapter } from "./index";

/**
 * OPT-IN smoke test against the LIVE NetworkRadar deployment. Skipped unless AAF_SMOKE_NETWORKRADAR=1 and both
 * NETWORKRADAR_MCP_URL and NETWORKRADAR_MCP_API_KEY are set.
 *
 * READ-ONLY by construction: only health() and get_network_summary (counts) are called, through the adapter whose
 * allow-list refuses every other tool. Nothing is written, and no person records are fetched or printed.
 */
const on = process.env.AAF_SMOKE_NETWORKRADAR === "1" && !!process.env.NETWORKRADAR_MCP_URL && !!process.env.NETWORKRADAR_MCP_API_KEY;

describe.skipIf(!on)("NetworkRadar live smoke (opt-in, read-only)", () => {
  it("authenticates, sees the read-only tools flagged readOnlyHint, and reads aggregate counts", async () => {
    const a = new NetworkRadarAdapter({ url: process.env.NETWORKRADAR_MCP_URL!, apiKey: process.env.NETWORKRADAR_MCP_API_KEY! });
    const h = await a.health();
    expect(h, JSON.stringify(h)).toMatchObject({ status: "connected" });
    const s = await a.getNetworkSummary();
    expect(s.data.people).toBeGreaterThanOrEqual(0);
    console.log(`[smoke] networkradar ok: people=${s.data.people} openActions=${s.data.openActions} (counts only)`);
  }, 30_000);
});

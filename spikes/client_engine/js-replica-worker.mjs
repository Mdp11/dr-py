// THROWAWAY SPIKE — runs the JS replica workloads off the main thread.
import { bigTable, loadReplica, nativeCells, searchScan } from "/js-replica.mjs";

self.onmessage = async () => {
  try {
    const { replica, timings } = await loadReplica("/snapshot.json.gz");
    postMessage({
      ok: true,
      result: {
        open: timings,
        big_table: bigTable(replica),
        search: searchScan(replica),
        script_cells: nativeCells(replica),
      },
    });
  } catch (err) {
    postMessage({ ok: false, error: String(err) });
  }
};

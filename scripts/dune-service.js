const { DuneClient } = require("@duneanalytics/client-sdk");
const fs = require('fs').promises;
const path = require('path');

const DUNE_API_KEY = process.env.DUNE_API_KEY;
const QUERY_ID = 5738104;
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'dune_cache.json');
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches the latest results from a Dune query, using a local cache to avoid redundant API calls.
 * NOTE: The Dune query should be configured to return data for ALL depositors, not just one hardcoded address.
 * The client will then filter for the specific depositor and cache results for 24 hours.
 * @param {boolean} force - Force fresh fetch by ignoring cache
 * @param {string} depositor - Depositor address to filter (optional)
 * @returns {Promise<object>} The query results.
 */
async function getDuneData(force = false, depositor = null) {
    if (!DUNE_API_KEY) {
        throw new Error("DUNE_API_KEY not found in .env file");
    }

    try {
        const stats = await fs.stat(CACHE_FILE);
        const cacheAge = Date.now() - stats.mtimeMs;
        if (cacheAge < CACHE_DURATION_MS) {
            const cachedData = await fs.readFile(CACHE_FILE, 'utf8');
            const cached = JSON.parse(cachedData);

            // If depositor is specified, check if cache contains data for this depositor
            // Note: Cache should contain ALL depositors if the Dune query is properly configured
            if (depositor) {
                const cachedDepositor = cached.result.rows.find(
                    row => row.depositor && row.depositor.toLowerCase() === depositor.toLowerCase()
                );
                if (cachedDepositor) {
                    console.log(`Using cached data for depositor: ${depositor}`);
                    // Return filtered result with only this depositor's data
                    const filteredResult = {
                        ...cached,
                        result: {
                            ...cached.result,
                            rows: [cachedDepositor],
                            metadata: {
                                ...cached.result.metadata,
                                row_count: 1
                            }
                        }
                    };
                    return filteredResult;
                } else {
                    console.log(`Cache does not contain data for depositor: ${depositor}, fetching fresh data`);
                }
            } else {
                if (!force) {
                    console.log("Returning cached Dune data.");
                    return cached;
                }
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn("Could not read cache file:", error);
        }
    }

    console.log(`Fetching fresh data from Dune API${depositor ? ` for depositor: ${depositor}` : ''}...`);
    const dune = new DuneClient(DUNE_API_KEY);
    const result = await dune.getLatestResult({ queryId: QUERY_ID });

    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');

    console.log("Dune API Response:", JSON.stringify(result, null, 2));

    return result;
}

module.exports = { getDuneData };
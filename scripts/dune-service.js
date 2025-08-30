const { DuneClient } = require("@duneanalytics/client-sdk");
const fs = require('fs').promises;
const path = require('path');

const DUNE_API_KEY = process.env.DUNE_API_KEY;
const QUERY_ID = 5026187;
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'dune_cache.json');
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches the latest results from a Dune query, using a local cache to avoid redundant API calls.
 * @returns {Promise<object>} The query results.
 */
async function getDuneData(force = false) {
    if (!DUNE_API_KEY) {
        throw new Error("DUNE_API_KEY not found in .env file");
    }

    if (!force) {
        try {
            const stats = await fs.stat(CACHE_FILE);
            const cacheAge = Date.now() - stats.mtimeMs;
            if (cacheAge < CACHE_DURATION_MS) {
                console.log("Returning cached Dune data.");
                const cachedData = await fs.readFile(CACHE_FILE, 'utf8');
                return JSON.parse(cachedData);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn("Could not read cache file:", error);
            }
        }
    }

    console.log("Fetching fresh data from Dune API...");
    const dune = new DuneClient(DUNE_API_KEY);
    const result = await dune.getLatestResult({ queryId: QUERY_ID });

    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');

    console.log("Dune API Response:", JSON.stringify(result, null, 2));

    return result;
}

module.exports = { getDuneData };
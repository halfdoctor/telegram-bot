const { DuneClient } = require("@duneanalytics/client-sdk");
const fs = require('fs').promises;
const path = require('path');

const DUNE_API_KEY = process.env.DUNE_API_KEY;
const QUERY_ID = 5026187;
const CACHE_FILE = path.join(__dirname, '..', 'cache', 'dune_cache.json');
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches the latest results from a Dune query, using a local cache to avoid redundant API calls.
 * @param {boolean} force - Force fresh fetch by ignoring cache
 * @param {string} depositor - Depositor address to filter (optional, if provided, will execute new query)
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
            if (depositor) {
                const hasDepositor = cached.result.rows.some(
                    row => row.depositor.toLowerCase() === depositor.toLowerCase()
                );
                if (hasDepositor) {
                    console.log(`Using cached data for depositor: ${depositor}`);
                    return cached;
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

    if (depositor) {
        console.log(`Fetching fresh data from Dune API for depositor: ${depositor}`);
        const dune = new DuneClient(DUNE_API_KEY);
        try {
        const execution = await dune.runQuery({
            queryId: QUERY_ID,
            query_parameters: { depositor: depositor.toLowerCase() }
        });

        // Wait for execution to complete
        await execution.waitForExecutionToComplete();

        const result = await execution.getLatestResult();
        const resultData = result.result;

        await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await fs.writeFile(CACHE_FILE, JSON.stringify(resultData, null, 2), 'utf8');

        console.log("Dune API Response:", JSON.stringify(resultData, null, 2));

        return resultData;
        } catch (error) {
            console.log("Parameterized query failed, falling back to general query without parameters:", error.message);
            // Check if it's a rate limit error
            if (error.status === 429 || error.message.includes('Too many requests')) {
                console.log("Rate limit exceeded for Dune API. Consider upgrading plan or waiting.");
                // Return cached data if available, or empty result
                try {
                    const cachedData = await fs.readFile(CACHE_FILE, 'utf8');
                    const cached = JSON.parse(cachedData);
                    console.log("Returning available cached data due to rate limit.");
                    return cached;
                } catch (cacheError) {
                    console.log("No cached data available, returning empty result.");
                    return { result: { rows: [{ error: 'Too many requests to Dune API. Please upgrade plan or try again later.' }] } };
                }
            }

            // Fall back to general query without parameters to get all data
            const execution = await dune.runQuery({ queryId: QUERY_ID });
            await execution.waitForExecutionToComplete();
            const result = await execution.getLatestResult();

            // Filter the result for the specific depositor
            if (result.result && result.result.rows) {
                const filteredRows = result.result.rows.filter(row =>
                    row.depositor && row.depositor.toLowerCase() === depositor.toLowerCase()
                );
                const filteredResult = { ...result, result: { ...result.result, rows: filteredRows } };

                await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
                await fs.writeFile(CACHE_FILE, JSON.stringify(filteredResult, null, 2), 'utf8');

                console.log("Filtered Dune API Response:", JSON.stringify(filteredResult, null, 2));

                return filteredResult;
            } else {
                const emptyResult = { ...result, result: { ...result.result, rows: [] } };
                await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
                await fs.writeFile(CACHE_FILE, JSON.stringify(emptyResult, null, 2), 'utf8');

                console.log("No data found in fallback query");
                return emptyResult;
            }
        }
    } else {
        console.log("Fetching fresh data from Dune API...");
        const dune = new DuneClient(DUNE_API_KEY);
        const result = await dune.getLatestResult({ queryId: QUERY_ID });

        await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await fs.writeFile(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');

        console.log("Dune API Response:", JSON.stringify(result, null, 2));

        return result;
    }

    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(result, null, 2), 'utf8');

    console.log("Dune API Response:", JSON.stringify(result, null, 2));

    return result;
}

module.exports = { getDuneData };
const { ethers } = require("ethers");

/**
 * A JSON-RPC provider for public endpoints.
 *
 * Public RPCs rate-limit (Monad's answers roughly 15-25 requests a second) and
 * sit behind load balancers whose nodes can be a block or two apart. This
 * provider keeps at most `maxConcurrent` requests in flight and retries the
 * transient failures with backoff. A revert is never retried: it is an answer.
 *
 * A signed transaction is only re-sent when the endpoint refused the request
 * outright (rate limit, connection error), never after an answer about it.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TRANSIENT = /rate.?limit|too many requests|request limit|limit exceeded|429|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|bad gateway|service unavailable|gateway timeout|\b50[234]\b|header not found|block not found|unknown block|missing trie node|try again|temporarily/i;
const REFUSED = /rate.?limit|too many requests|request limit|429|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up/i;

function describe(error) {
    return [error && error.message, error && error.body, error && error.error && error.error.message]
        .filter(Boolean)
        .join(" ");
}

function shouldRetry(method, error) {
    const text = describe(error);
    if (/revert/i.test(text)) return false;
    return method === "eth_sendRawTransaction" ? REFUSED.test(text) : TRANSIENT.test(text);
}

class ResilientProvider extends ethers.providers.StaticJsonRpcProvider {
    constructor(url, chainId, { maxConcurrent = 4, retries = 6, pollingInterval = 500 } = {}) {
        super(url, chainId);
        this.maxConcurrent = maxConcurrent;
        this.retries = retries;
        this.pollingInterval = pollingInterval;
        this._active = 0;
        this._waiting = [];
    }

    async _acquire() {
        if (this._active < this.maxConcurrent) {
            this._active += 1;
            return;
        }
        await new Promise((resolve) => this._waiting.push(resolve));
    }

    _release() {
        const next = this._waiting.shift();
        if (next) next();
        else this._active -= 1;
    }

    async send(method, params) {
        for (let attempt = 0; ; attempt++) {
            await this._acquire();
            try {
                return await super.send(method, params);
            } catch (error) {
                if (attempt >= this.retries || !shouldRetry(method, error)) throw error;
            } finally {
                this._release();
            }
            await sleep(400 * 2 ** attempt);   // 0.4 s, 0.8 s, 1.6 s, ...
        }
    }
}

module.exports = { ResilientProvider };

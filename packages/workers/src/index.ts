/**
 * @cre/workers
 *
 * Background workers (crawling pipeline, lead generation).
 *
 * Workers are added here as they are implemented; the entry keeps the
 * container alive so compose does not spin `restart: unless-stopped`
 * on an empty module.
 */
export {};

// Keep-alive: registered workers resolve above; idle until terminated
// (SIGTERM on compose stop).
const keepAlive = setInterval(() => undefined, 1 << 30);

// Compatibility entry point. Reject every argument before importing preflight.
if (process.argv.length > 2) throw new Error('Dry-run only: no execution flags accepted.');
await import('./deploy-flarehq-escrow.mjs');

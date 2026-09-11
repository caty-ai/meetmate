// Node 26 treats an explicit directory test argument as a module entry.
// Keep the requested `node --test docs/research/h3-avatar-probe/` runnable.
void import('./generate-clips.test.mjs');

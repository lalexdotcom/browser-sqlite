// A git hook runs these tests with git's own variables in the environment, and
// every git a test starts inherits them. `git commit -a` exports an absolute
// `GIT_INDEX_FILE` to its temporary index: a git run in a test's scratch
// repository then builds trees from this repository's index, whose objects it
// does not have ("invalid object … Error building trees"). The scripts keep
// those variables — a hook's git must read the index being committed.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) delete process.env[name];
}

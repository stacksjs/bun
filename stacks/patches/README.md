# Pinned patch series

`stacks/patches/<official tag>/` holds our changes as they are on one official release, when the changes on this branch (written against upstream's `main`) do not merge onto that tag. `stacks-build.yml` applies the series with `git am` in file name order, in place of the branch's changes.

A tag without a folder here gets the branch's changes, merged onto it three ways.

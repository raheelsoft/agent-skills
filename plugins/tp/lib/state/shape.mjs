// shape.mjs — `state.mjs shape [<artifact>]`: the form `put` accepts (lib/contract/shape.mjs), asked for by the name a file has, a repo suffix and all.
import { shapeOf, catalogue } from '../contract/index.mjs';
import { CliError } from './util.mjs';

/** The short form of one artifact (`implement`, `implement.shop-web`, `triage.json`), or the list of them without a name. */
export function shape(target) {
  try {
    return target ? shapeOf(String(target).replace(/\.json$/, '').replace(/^(implement|pr|release)\..+$/, '$1')) : catalogue();
  } catch (e) { throw new CliError(e.message, 2); }
}

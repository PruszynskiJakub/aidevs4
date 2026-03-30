import { register, getTools, getToolsByName, dispatch, reset } from "./registry.ts";

import think from "./think.ts";
import bash from "./bash.ts";
import agents_hub from "./agents_hub.ts";
import web from "./web.ts";
import geo_distance from "./geo_distance.ts";
import shipping from "./shipping.ts";
import document_processor from "./document_processor.ts";
import prompt_engineer from "./prompt_engineer.ts";
import read_file from "./read_file.ts";
import write_file from "./write_file.ts";
import edit_file from "./edit_file.ts";
import glob from "./glob.ts";
import grep from "./grep.ts";
import execute_code from "./execute_code.ts";
import delegate from "./delegate.ts";

register(think);
register(bash);
register(agents_hub);
register(web);
register(geo_distance);
register(shipping);
register(document_processor);
register(prompt_engineer);
register(read_file);
register(write_file);
register(edit_file);
register(glob);
register(grep);
register(execute_code);
register(delegate);

export { register, getTools, getToolsByName, dispatch, reset };

import { register, getTools, dispatch, reset } from "./registry.ts";

import think from "./think.ts";
import thinkSchema from "../schemas/think.json";
import bash from "./bash.ts";
import bashSchema from "../schemas/bash.json";
import agents_hub from "./agents_hub.ts";
import agentsHubSchema from "../schemas/agents_hub.json";
import web from "./web.ts";
import webSchema from "../schemas/web.json";
import geo_distance from "./geo_distance.ts";
import geoDistanceSchema from "../schemas/geo_distance.json";
import shipping from "./shipping.ts";
import shippingSchema from "../schemas/shipping.json";
import document_processor from "./document_processor.ts";
import documentProcessorSchema from "../schemas/document_processor.json";

register(think, thinkSchema);
register(bash, bashSchema);
register(agents_hub, agentsHubSchema);
register(web, webSchema);
register(geo_distance, geoDistanceSchema);
register(shipping, shippingSchema);
register(document_processor, documentProcessorSchema);

export { getTools, dispatch, reset };

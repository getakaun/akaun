import { EventEmitter } from "node:events";

/** Only committed boundary changes are published; previews carry no live financial data. */
export const closingEvents = new EventEmitter();
closingEvents.setMaxListeners(200);

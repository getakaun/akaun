import { DeferrableEmitter } from "../unit-of-work.js";

/** Only committed boundary changes are published; previews carry no live financial data. */
export const closingEvents = new DeferrableEmitter();
closingEvents.setMaxListeners(200);

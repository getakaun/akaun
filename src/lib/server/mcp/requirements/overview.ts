import { ANY_READ, readTool } from "./define.js";

/**
 * `get_books_overview`: listed to anyone who can read some area. It decides
 * per area when it runs — balances only with accounts read, work-queue
 * counts only for the queues the caller may read — and reports which write
 * actions this credential may use from the requirement tables.
 */
export const GET_BOOKS_OVERVIEW = readTool(ANY_READ);

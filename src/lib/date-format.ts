/**
 * "28 Feb 2026" from "2026-02-28". Kept free of any client state so the
 * server can use it too (month-closing notices name dates this way).
 */
export function formatDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

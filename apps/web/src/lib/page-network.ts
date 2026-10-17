import { notFound } from "next/navigation";
import { firstParam, networkOf, type Network, type SearchParams } from "./networks";

export async function pageNetwork(searchParams: Promise<SearchParams>): Promise<Network> {
  const query = await searchParams;
  try { return networkOf(firstParam(query.network)); } catch { notFound(); }
}

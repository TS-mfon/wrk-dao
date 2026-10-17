import { handleVercelApi } from "@wrk/api/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request) { return handleVercelApi(request); }

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;

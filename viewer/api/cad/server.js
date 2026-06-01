import { handleHostedCadApi } from "../../src/server/vercelApi.mjs";


export default async function handler(req, res) {
  await handleHostedCadApi(req, res, { cadPath: "/__cad/server" });
}

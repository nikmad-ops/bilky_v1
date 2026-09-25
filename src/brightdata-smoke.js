import {
  createProductionClient,
  madridDate,
  log,
} from "./production-core.js";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BRIGHTDATA_CDP_URL,
} = process.env;

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BRIGHTDATA_CDP_URL,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

const date = madridDate();

const client = createProductionClient({
  nif: BILKY_NIF,
  password: BILKY_PASSWORD,
  brightDataCdpUrl: BRIGHTDATA_CDP_URL,
  attempt: 1,
});

try {
  const result = await client.inspect("morning", date);
  log("BRIGHTDATA_SMOKE_SUCCESS");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await client.close();
}

import { createApp } from "./app";
import { InMemoryRepository } from "./repository";
import { HaversineProvider } from "../optimizer/travelTime";
import { StubExtractor } from "../ingest/extractor";
import { demoAssignments, demoDrivers, demoRoutes, demoManifests } from "../demo/dataset";

// Local dev server over the synthetic demo dataset.
const port = Number(process.env.PORT ?? 3000);
const app = createApp({
  repo: new InMemoryRepository(demoDrivers, demoRoutes, demoAssignments),
  travel: new HaversineProvider(),
  extractor: new StubExtractor(demoManifests),
});

app.listen(port, () => {
  console.log(`dispatch-showcase API listening on http://localhost:${port}`);
});

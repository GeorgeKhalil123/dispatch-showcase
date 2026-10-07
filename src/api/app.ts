import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { solve } from "../optimizer/solve";
import type { TravelTimeProvider } from "../optimizer/travelTime";
import { ExtractionError, previewExtraction, type Extractor } from "../ingest/extractor";
import type { DispatchRepository } from "./repository";
import { httpError, requireFields, validateDate, validatePositiveNumber } from "./validate";
import { importPreviewSchema, optimizeRequestSchema, zodErrorToHttp } from "./schemas";
import { errorHandler } from "./errorHandler";

export interface AppDeps {
  repo: DispatchRepository;
  travel: TravelTimeProvider;
  extractor: Extractor;
}

export function createApp({ repo, travel, extractor }: AppDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Every endpoint takes JSON. A body sent with another Content-Type would
  // otherwise be ignored by express.json() and fail confusingly downstream.
  // No Content-Type at all leaves req.body unset; the field checks 400 that.
  // req.is() returns null when the request has no body (e.g. a GET), so only
  // requests that actually carry a non-JSON body are rejected.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.headers["content-type"] && req.is("application/json") === false) {
      return next(httpError("Unsupported Media Type: send the body as application/json", 415));
    }
    next();
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, travel_provider: travel.name });
  });

  // -------------------------------------------------------------------------
  // POST /optimize — run the solver; returns a proposal, commits nothing
  // -------------------------------------------------------------------------
  app.post(
    "/optimize",
    requireFields("date"),
    validateDate("date"),
    validatePositiveNumber("buffer_minutes"),
    async (req: Request, res: Response, next: NextFunction) => {
      // Structural validation via zod after the cheap field checks, so a
      // malformed body fails as a 400 instead of a 500 deep in the solver.
      const parsed = optimizeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(zodErrorToHttp(parsed.error));
      }

      try {
        const { date, buffer_minutes, preserve_existing, max_iterations } = parsed.data;
        const [drivers, routes, existing] = await Promise.all([
          repo.listDrivers(),
          repo.listRoutes(),
          preserve_existing ? repo.listAssignments(date) : Promise.resolve([]),
        ]);
        const result = await solve({ drivers, routes, existing }, travel, { buffer_minutes, max_iterations });
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /import/preview — extract + score rows for human review
  // -------------------------------------------------------------------------
  app.post("/import/preview", requireFields("filename"), async (req: Request, res: Response, next: NextFunction) => {
    const parsed = importPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(zodErrorToHttp(parsed.error));
    }

    try {
      const { filename, content } = parsed.data;
      const preview = await previewExtraction(extractor, filename, content);
      res.status(200).json(preview);
    } catch (err) {
      next(
        err instanceof SyntaxError || err instanceof ExtractionError
          ? httpError(`Could not parse document: ${err.message}`, 422)
          : err,
      );
    }
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(httpError(`Not found: ${req.method} ${req.path}`, 404));
  });

  app.use(errorHandler);
  return app;
}

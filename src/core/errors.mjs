// Work Core errors.
//
// Shared actions throw WorkError for business-rule failures (invalid
// transition, missing task, missing session, missing title). The API layer
// maps `status` to HTTP status codes; the CLI prints `message`. One error
// type keeps the CLI and the Web API speaking the same language.

export class WorkError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "WorkError";
    this.status = status;
  }
}

import { Logger } from '@/Util/Logger.js';

declare function SetHttpHandler(Handler: (Request: HttpRequest, Response: HttpResponse) => void): void;

/** Inbound HTTP request as FXServer hands it to us. */
export interface HttpRequest {
  address: string;
  headers: Record<string, string>;
  method: string;
  /** Path WITHOUT the resource prefix; e.g. `/auth/discord/callback`. */
  path: string;
  setDataHandler(Cb: (Body: string) => void): void;
  setDataHandler(Cb: (Body: Uint8Array) => void, Binary: 'binary'): void;
  setCancelHandler(Cb: () => void): void;
}

/** Response as FXServer hands it to us. */
export interface HttpResponse {
  writeHead(Status: number, Headers?: Record<string, string | string[]>): void;
  write(Data: string): void;
  send(Data?: string): void;
}

export type RouteHandler = (Request: HttpRequest, Response: HttpResponse, Query: URLSearchParams) => void | Promise<void>;

/**
 * Path-based dispatch over the single `SetHttpHandler`.
 *
 * FXServer exposes ONE HTTP handler per resource - all requests to
 * `http://host:port/<resource>/...` come through it. We split on method+
 * pathname so multiple features can plug in clean routes without
 * stepping on each other.
 *
 *   Router.Get('/auth/discord/callback', (req, res, query) => { ... });
 *
 * Unmatched paths -> 404. Handlers may be sync or async; if a handler
 * throws, we log it and reply 500 (rather than leaving the connection
 * hanging).
 */
export class HttpRouter {
  private readonly Log = Logger.New('HTTP');
  private readonly Routes = new Map<string, RouteHandler>();
  private Mounted = false;

  Get(Path: string, Handler: RouteHandler): void {
    this.Routes.set(this.Key('GET', Path), Handler);
  }

  Post(Path: string, Handler: RouteHandler): void {
    this.Routes.set(this.Key('POST', Path), Handler);
  }

  /** Installs the single FXServer handler. Call once after routes are registered. */
  Mount(): void {
    if (this.Mounted) return;
    this.Mounted = true;
    SetHttpHandler((Request, Response) => this.Dispatch(Request, Response));
    this.Log.Info(`Mounted with ${this.Routes.size} route(s)`);
  }

  private Dispatch(Request: HttpRequest, Response: HttpResponse): void {
    // Split path from query string. `path` from FXServer can include `?...`.
    const QueryIdx = Request.path.indexOf('?');
    const Pathname = QueryIdx === -1 ? Request.path : Request.path.slice(0, QueryIdx);
    const QueryString = QueryIdx === -1 ? '' : Request.path.slice(QueryIdx + 1);
    const Query = new URLSearchParams(QueryString);

    const Handler = this.Routes.get(this.Key(Request.method, Pathname));
    if (Handler === undefined) {
      Response.writeHead(404, { 'Content-Type': 'text/plain' });
      Response.send('Not Found');
      return;
    }

    Promise.resolve()
      .then(() => Handler(Request, Response, Query))
      .catch((Err: unknown) => {
        this.Log.Error(`Handler ${Request.method} ${Pathname} threw`, { Err: String(Err) });
        try {
          Response.writeHead(500, { 'Content-Type': 'text/plain' });
          Response.send('Internal Server Error');
        } catch {
          // Response may already be sent; nothing useful left to do.
        }
      });
  }

  private Key(Method: string, Path: string): string {
    return `${Method.toUpperCase()} ${Path}`;
  }
}

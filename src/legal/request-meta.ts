import type { Request } from 'express';
import type { ConsentRequestMeta } from './legal.service';

/** Longest user-agent we keep — enough to identify a browser, not a log dump. */
const MAX_USER_AGENT = 512;

/**
 * Evidence attached to a consent: who ticked the box, from where.
 *
 * Behind a proxy (nginx, a load balancer) `req.ip` is the proxy's address
 * unless Express is told to trust it — see `app.set('trust proxy', …)` in
 * main.ts. This is supporting evidence, not an identity check: a client can
 * claim any forwarded address, so nothing is authorized on it.
 */
export function requestMeta(req: Request): ConsentRequestMeta {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, MAX_USER_AGENT) ?? null,
  };
}

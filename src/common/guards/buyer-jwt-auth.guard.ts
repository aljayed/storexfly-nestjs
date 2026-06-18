import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Requires a valid buyer-session token. Use on review-write endpoints. */
@Injectable()
export class BuyerJwtAuthGuard extends AuthGuard('buyer-jwt') {}

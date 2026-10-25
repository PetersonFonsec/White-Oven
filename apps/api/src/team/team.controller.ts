import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AdminRoute } from "../auth/staff.guard";
import { PublicRoute } from "../auth/route-access";
import { clientIp } from "../auth/staff-auth.controller";
import type { MembershipRole } from "../auth/staff.entity";
import { ApiError } from "../errors/api-error";
import { requestIdOf } from "../logging/request-context";
import { TEAM_ROLES, TeamService } from "./team.service";

class InviteBody {
  @ApiProperty({ format: "email" }) email!: string;
  @ApiProperty({ enum: TEAM_ROLES }) role!: MembershipRole;
}
class RoleBody {
  @ApiProperty({ enum: TEAM_ROLES }) role!: MembershipRole;
}
class TokenBody {
  @ApiProperty({ minLength: 43, maxLength: 43 }) token!: string;
}
class RedeemBody extends TokenBody {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 120,
    description: "Required only when the invitee has no account yet",
  })
  name?: string;
  @ApiProperty({
    format: "password",
    description: "A new password, or the existing account's password",
  })
  password!: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Exactly `required` (strings) plus any of `optional`; anything else is a 422. */
function body(
  raw: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, string> {
  const allowed = [...required, ...optional];
  const paths = isObject(raw)
    ? [
        ...required.filter(
          (key) => typeof raw[key] !== "string" || raw[key] === "",
        ),
        ...optional.filter((key) => key in raw && typeof raw[key] !== "string"),
        ...Object.keys(raw).filter((key) => !allowed.includes(key)),
      ]
    : [""];
  if (paths.length)
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "VALIDATION_FAILED",
      "Invalid request body.",
      { errors: paths.map((path) => ({ code: "VALIDATION_FAILED", path })) },
    );
  return raw as Record<string, string>;
}

function role(value: string): MembershipRole {
  if (!(TEAM_ROLES as readonly string[]).includes(value))
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      "VALIDATION_FAILED",
      "Invalid request body.",
      { errors: [{ code: "VALIDATION_FAILED", path: "role" }] },
    );
  return value as MembershipRole;
}

@ApiTags("team")
@Controller("admin/team")
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @AdminRoute("OWNER")
  @ApiOperation({ summary: "List active members and pending invitations" })
  list() {
    return this.team.list();
  }

  @Post("invites")
  @AdminRoute("OWNER")
  @ApiBody({ type: InviteBody })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "8–128 ASCII characters; a retry with the same key and body returns the same link.",
  })
  @ApiOperation({
    summary: "Invite a person; the single-use link is returned once",
    description:
      "Replaces a pending invitation for the same e-mail. 409 ALREADY_MEMBER when the person is already active in the store.",
  })
  async invite(
    @Body() raw: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const fields = body(raw, ["email", "role"]);
    res.setHeader("Cache-Control", "no-store");
    return this.team.invite(
      fields.email!,
      role(fields.role!),
      idempotencyKey ?? "",
      requestIdOf(req),
    );
  }

  @Delete("invites/:inviteId")
  @AdminRoute("OWNER")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Cancel a pending invitation" })
  async cancelInvite(@Param("inviteId") inviteId: string, @Req() req: Request) {
    await this.team.cancelInvite(inviteId, requestIdOf(req));
  }

  @Patch("members/:membershipId")
  @AdminRoute("OWNER")
  @ApiBody({ type: RoleBody })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Change a member's role",
    description:
      "409 LAST_OWNER when it would leave the store without an owner.",
  })
  async changeRole(
    @Param("membershipId") membershipId: string,
    @Body() raw: unknown,
    @Req() req: Request,
  ) {
    const fields = body(raw, ["role"]);
    await this.team.changeRole(
      membershipId,
      role(fields.role!),
      requestIdOf(req),
    );
  }

  @Delete("members/:membershipId")
  @AdminRoute("OWNER")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Revoke a member and end their sessions in this store",
    description: "409 LAST_OWNER for the store's only owner.",
  })
  async revoke(
    @Param("membershipId") membershipId: string,
    @Req() req: Request,
  ) {
    await this.team.revokeMember(membershipId, requestIdOf(req));
  }
}

@ApiTags("team invites")
@Controller("team/invites")
export class TeamInviteController {
  constructor(private readonly team: TeamService) {}

  @Post("preview")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: TokenBody })
  @ApiOperation({
    summary: "Store, role and account state of a pending invite",
  })
  preview(@Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const fields = body(raw, ["token"]);
    res.setHeader("Cache-Control", "no-store");
    return this.team.preview(fields.token!);
  }

  @Post("redeem")
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: RedeemBody })
  @ApiOperation({
    summary: "Accept a team invitation",
    description:
      "Creates the account (name and new password) or, when the e-mail already has one, confirms it with that account's password under the login lockout.",
  })
  redeem(@Body() raw: unknown, @Req() req: Request) {
    const fields = body(raw, ["token", "password"], ["name"]);
    return this.team.redeem(
      fields.token!,
      fields.name ?? null,
      fields.password!,
      clientIp(req),
      requestIdOf(req),
    );
  }
}

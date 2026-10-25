import { Module } from "@nestjs/common";
import { TeamController, TeamInviteController } from "./team.controller";
import { TeamService } from "./team.service";

@Module({
  controllers: [TeamController, TeamInviteController],
  providers: [TeamService],
})
export class TeamModule {}

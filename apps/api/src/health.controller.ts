import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./database/prisma.service.ts";

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("health")
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", checkedAt: new Date().toISOString() };
  }
}

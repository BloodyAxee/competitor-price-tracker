import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.ts";

const app = await NestFactory.create(AppModule);
const port = Number(process.env.API_PORT ?? 3000);

app.enableCors({
  origin: process.env.CORS_ORIGIN?.split(",").map((value) => value.trim()) ?? true,
});
app.enableShutdownHooks();

await app.listen(port, "0.0.0.0");

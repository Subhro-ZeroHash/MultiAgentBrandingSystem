import { Module } from '@nestjs/common';
import { AiResearchController } from './ai-research.controller.js';
import { AiResearchService } from './ai-research.service.js';
import { IntelligenceController } from './intelligence.controller.js';
import { IntelligenceService } from './intelligence.service.js';

@Module({
  controllers: [IntelligenceController, AiResearchController],
  providers: [IntelligenceService, AiResearchService],
})
export class IntelligenceModule {}

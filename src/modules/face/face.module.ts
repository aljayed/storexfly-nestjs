import { Module } from '@nestjs/common';
import { FaceEngineService } from './engine/face-engine.service';
import { FrameAnalysisService } from './engine/frame-analysis.service';
import { FaceEnrollmentService } from './face-enrollment.service';
import { FaceReviewService } from './face-review.service';
import { FaceController } from './face.controller';
import { FaceService } from './face.service';

@Module({
  controllers: [FaceController],
  providers: [
    FaceEngineService,
    FrameAnalysisService,
    FaceEnrollmentService,
    FaceReviewService,
    FaceService,
  ],
  exports: [FaceService, FaceReviewService],
})
export class FaceModule {}

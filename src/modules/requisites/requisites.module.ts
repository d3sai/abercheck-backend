import { Module } from '@nestjs/common';
import { RequisitesService } from './requisites.service';

@Module({
  providers: [RequisitesService],
  exports: [RequisitesService],
})
export class RequisitesModule {}

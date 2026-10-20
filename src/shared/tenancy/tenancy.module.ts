import { Global, Module } from '@nestjs/common';
import { PersonFactsReader } from './person-facts.reader';

/** Scope helpers every module may use (docs/4.0/SPEC.md 4). */
@Global()
@Module({
  providers: [PersonFactsReader],
  exports: [PersonFactsReader],
})
export class TenancyModule {}

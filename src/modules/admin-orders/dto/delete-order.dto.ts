import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/trim.decorator';

export class DeleteOrderDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  confirm!: string;

  @IsIn(['detach', 'delete'])
  payments!: 'detach' | 'delete';
}

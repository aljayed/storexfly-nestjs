import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** The bank/wallet account monthly settlement payouts are transferred to. */
export class PayoutBankDto {
  @ApiProperty({ example: 'BRAC Bank' })
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(120)
  bankName!: string;

  @ApiProperty({ example: 'Mango Shop Ltd.' })
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(160)
  accountName!: string;

  @ApiProperty({ example: '1510123456789' })
  @IsString()
  @Transform(trim)
  @MinLength(4)
  @MaxLength(40)
  accountNumber!: string;

  @ApiPropertyOptional({ example: 'Gulshan branch' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(120)
  branch?: string;
}

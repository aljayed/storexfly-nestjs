import { PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';

/** All create fields optional — used for inline edits (price, stock, etc.). */
export class UpdateProductDto extends PartialType(CreateProductDto) {}

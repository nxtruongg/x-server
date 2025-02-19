import { Controller } from '@nestjs/common';
import { BaseController } from '@/base/base.controller';
import { Product } from '@/database/schemas/product.schema';
import { ProductService } from './product.service';

@Controller('product')
export class ProductController extends BaseController<Product> {
  constructor(private readonly productService: ProductService) {
    super(productService);
  }
}

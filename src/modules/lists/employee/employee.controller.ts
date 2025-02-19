import { Controller } from '@nestjs/common';
import { BaseController } from '@/base/base.controller';
import { Employee } from '@/database/schemas/employee.schema';
import { EmployeeService } from './employee.service';

@Controller('employee')
export class EmployeeController extends BaseController<Employee> {
  constructor(private readonly employeeService: EmployeeService) {
    super(employeeService);
  }
}

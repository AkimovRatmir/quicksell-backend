import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminService } from './admin.service';
import {
  AdminSellersQueryDto,
  AdminUsersQueryDto,
  UpdatePlanDto,
} from './dto/admin.dto';

/**
 * Internal admin panel API. Every route requires a valid JWT AND role='admin'
 * (checked fresh from the DB by AdminGuard). Cross-tenant — founders only.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@ApiForbiddenResponse({ description: 'Admin access required.' })
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Platform KPIs (users, sellers, data, usage)' })
  overview() {
    return this.admin.overview();
  }

  @Get('users')
  @ApiOperation({ summary: 'List all users (search, filter by plan, paginated)' })
  users(@Query() q: AdminUsersQueryDto) {
    return this.admin.listUsers(q);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'One user: profile + their sellers + usage' })
  user(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.getUser(id);
  }

  @Patch('users/:id/plan')
  @ApiOperation({ summary: "Change a user's subscription plan (free/pro)" })
  setPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.admin.setPlan(id, dto);
  }

  @Get('sellers')
  @ApiOperation({ summary: 'Seller health board across all users' })
  sellers(@Query() q: AdminSellersQueryDto) {
    return this.admin.listSellers(q);
  }
}
